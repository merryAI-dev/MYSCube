import { describe, expect, it, vi } from 'vitest';
import { proposeWorkPage, answerCashflowQuestion } from './workbench-assistant.mjs';

const input = { question: '현금흐름을 표로 보여줘', yearMonth: '2026-09' };
const config = { schemaVersion: 1, title: '현금흐름', description: '', source: 'cashflow-evidence', presentation: 'table', yearMonth: '2026-09', search: '' };
const signal = () => new AbortController().signal;
const proposal = (value) => ({ tool_calls: [{ function: { name: 'propose_page', arguments: JSON.stringify(value) } }] });

describe('workbench model boundary', () => {
  it('accepts only a validated proposal and never automatically saves it', async () => {
    const complete = vi.fn().mockResolvedValue(proposal(config));
    expect(await proposeWorkPage({ complete, input, signal: signal() })).toEqual({ config, saved: false, requiresReview: true });
  });
  it.each([{ ...config, script: 'fetch("secret")' }, { ...config, source: 'http://localhost' }, { ...config, yearMonth: '2025-01' }])('rejects executable/unregistered/wrong-period proposals', async (value) => {
    await expect(proposeWorkPage({ complete: vi.fn().mockResolvedValue(proposal(value)), input, signal: signal() })).rejects.toThrow();
  });
  it('does not show an unsupported model answer without tool evidence', async () => {
    const result = await answerCashflowQuestion({ complete: vi.fn().mockResolvedValue({ content: '모든 정산이 완료됐습니다.' }),
      reviewComplete: vi.fn(), query: vi.fn(), context: { actorRole: 'pm' }, input, signal: signal() });
    expect(result.status).toBe('unverified');
    expect(result.answer).not.toContain('모든 정산이 완료');
    expect(result.evidence).toEqual([]);
  });
  it('binds tools to the authenticated actor and does not expose diagnostic tool to a member', async () => {
    const complete = vi.fn().mockResolvedValue({ content: '' });
    const context = { tenantId: 'mysc', actorId: 'pm', actorRole: 'pm' };
    await answerCashflowQuestion({ complete, reviewComplete: vi.fn(), query: vi.fn(), readDiagnostics: vi.fn(), context, input, signal: signal() });
    const names = complete.mock.calls[0][0].tools.map((tool) => tool.function.name);
    expect(names).toEqual(['cashflow_evidence']);
    expect(complete.mock.calls[0][0].tools[0].function.parameters.properties).not.toHaveProperty('actorId');
  });
});

it('QA assistant refuses unsupported answers when no actual evidence tool ran', async () => {
  const { answerQaQuestion } = await import('./workbench-assistant.mjs');
  const query = vi.fn();
  const result = await answerQaQuestion({ complete: vi.fn().mockResolvedValue({ content: '서버가 원인입니다.' }), reviewComplete: vi.fn(), query,
    context: { actorRole: 'admin' }, input: { question: '실패 원인?', area: 'draft' }, signal: signal() });
  expect(result.status).toBe('unverified'); expect(result.answer).not.toContain('서버가 원인입니다'); expect(query).not.toHaveBeenCalled();
});

it('model proposal supports the registered CEO widget schema without saving data', async () => {
  const { proposeInsightLayout } = await import('../../shared/insight-page.mjs');
  const dashboard = proposeInsightLayout('현금흐름과 품질 오류 추이', input.yearMonth).config;
  const result = await proposeWorkPage({ complete: vi.fn().mockResolvedValue(proposal(dashboard)), input, signal: signal() });
  expect(result.config.schemaVersion).toBe(2); expect(result.saved).toBe(false);
});
